<?php
/**
 * Frontend Redirect System
 *
 * Handles redirecting non-admin users from wp-admin to appropriate portals
 * and manages login redirects based on user roles.
 *
 * @package    Kelbe_Project_Tracker
 * @subpackage Kelbe_Project_Tracker/includes
 * @since      1.0.0
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
	die;
}

/**
 * Frontend Redirect Class
 *
 * @since 1.0.0
 */
class KPT_Frontend_Redirect {

	/**
	 * The single instance of the class.
	 *
	 * @since  1.0.0
	 * @access protected
	 * @var    KPT_Frontend_Redirect
	 */
	protected static $instance = null;

	/**
	 * Main Instance
	 *
	 * Ensures only one instance of the class is loaded or can be loaded.
	 *
	 * @since  1.0.0
	 * @return KPT_Frontend_Redirect - Main instance.
	 */
	public static function instance() {
		if ( is_null( self::$instance ) ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Constructor
	 *
	 * @since 1.0.0
	 */
	private function __construct() {
		$this->init_hooks();
	}

	/**
	 * Initialize hooks
	 *
	 * @since 1.0.0
	 */
	private function init_hooks() {
		add_action( 'admin_init', array( $this, 'redirect_non_admins_from_admin' ) );
		add_action( 'login_redirect', array( $this, 'smart_login_redirect' ), 10, 3 );
		add_action( 'wp_before_admin_bar_render', array( $this, 'hide_admin_bar_for_non_admins' ) );
		add_filter( 'show_admin_bar', array( $this, 'show_admin_bar' ) );
	}

	/**
	 * Redirect non-admin users from wp-admin to appropriate portal
	 *
	 * @since 1.0.0
	 */
	public function redirect_non_admins_from_admin() {
		// Allow AJAX requests.
		if ( wp_doing_ajax() ) {
			return;
		}

		// Allow users with manage_options capability (administrators).
		if ( current_user_can( 'manage_options' ) ) {
			return;
		}

		// Get the current user.
		$current_user = wp_get_current_user();

		// Determine portal URL based on user role or meta.
		$portal_url = $this->get_portal_url_for_user( $current_user );

		// Redirect if portal URL is determined.
		if ( $portal_url ) {
			wp_safe_redirect( $portal_url );
			exit;
		}
	}

	/**
	 * Smart login redirect based on user role
	 *
	 * @since 1.0.0
	 * @param string  $redirect_to           The redirect destination URL.
	 * @param string  $requested_redirect_to The requested redirect destination URL passed as a parameter.
	 * @param WP_User $user                  WP_User object.
	 * @return string Redirect URL.
	 */
	public function smart_login_redirect( $redirect_to, $requested_redirect_to, $user ) {
		// Check if user is valid.
		if ( ! isset( $user->ID ) ) {
			return $redirect_to;
		}

		// Allow administrators to go to wp-admin.
		if ( user_can( $user, 'manage_options' ) ) {
			return $redirect_to;
		}

		// Get portal URL for the user.
		$portal_url = $this->get_portal_url_for_user( $user );

		// Return portal URL if found, otherwise return default redirect.
		return $portal_url ? $portal_url : $redirect_to;
	}

	/**
	 * Hide admin bar for non-admin users
	 *
	 * @since 1.0.0
	 */
	public function hide_admin_bar_for_non_admins() {
		if ( ! current_user_can( 'manage_options' ) ) {
			add_filter( 'show_admin_bar', '__return_false' );
		}
	}

	/**
	 * Show/hide admin bar based on user capability
	 *
	 * @since  1.0.0
	 * @param  bool $show Whether to show the admin bar.
	 * @return bool
	 */
	public function show_admin_bar( $show ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			return false;
		}
		return $show;
	}

	/**
	 * Get portal URL for a specific user
	 *
	 * @since  1.0.0
	 * @param  WP_User $user User object.
	 * @return string|false Portal URL or false if none found.
	 */
	private function get_portal_url_for_user( $user ) {
		if ( ! $user || ! isset( $user->ID ) ) {
			return false;
		}

		// Check user meta for portal preference.
		$portal_type = get_user_meta( $user->ID, 'kpt_portal_type', true );

		if ( 'team' === $portal_type ) {
			return home_url( '/team-portal/' );
		}

		if ( 'client' === $portal_type ) {
			return home_url( '/client-portal/' );
		}

		// Fall back to role-based detection.
		$user_roles = (array) $user->roles;

		// Team portal roles: contractor, trade, kpt_contractor, kpt_trade.
		$team_roles = array( 'contractor', 'trade', 'kpt_contractor', 'kpt_trade' );
		foreach ( $team_roles as $role ) {
			if ( in_array( $role, $user_roles, true ) ) {
				return home_url( '/team-portal/' );
			}
		}

		// Client portal roles: customer, kpt_customer, kpt_client.
		$client_roles = array( 'customer', 'kpt_customer', 'kpt_client' );
		foreach ( $client_roles as $role ) {
			if ( in_array( $role, $user_roles, true ) ) {
				return home_url( '/client-portal/' );
			}
		}

		// No portal found.
		return false;
	}

	/**
	 * Prevent cloning of the instance
	 *
	 * @since 1.0.0
	 */
	private function __clone() {}

	/**
	 * Prevent unserializing of the instance
	 *
	 * @since 1.0.0
	 */
	private function __wakeup() {}
}

// Initialize the class.
KPT_Frontend_Redirect::instance();
